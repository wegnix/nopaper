import { z } from 'zod';
import { ALL_PERMISSIONS, withRequired, type Permission } from './permissions.js';
import { isoDate } from './schemas.js';

/**
 * Integrações: tokens da API pública (`/api/v1`) criados por espaço.
 * O token carrega uma lista de permissões do mesmo catálogo dos grupos; quem cria só concede o que tem.
 */
export const API_TOKEN_PREFIX = 'np_';
export const API_TOKENS_MAX = 20;
export const API_TOKEN_IPS_MAX = 20;
/** Chamadas por minuto de cada token. */
export const API_RATE_LIMIT_PER_MINUTE = 300;
/** O limite pode ser trocado por token (ex.: uma migração), dentro desta faixa. */
export const API_RATE_LIMIT_MIN = 60;
export const API_RATE_LIMIT_MAX = 3000;

/** O que nenhum token pode fazer: gestão do espaço continua só pela tela, com uma pessoa logada. */
export const INTEGRATION_FORBIDDEN_PERMISSIONS: Permission[] = ['members.manage', 'groups.manage', 'org.settings', 'alerts.manage', 'integrations.manage'];
export const INTEGRATION_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter((p) => !INTEGRATION_FORBIDDEN_PERMISSIONS.includes(p));

/** Modelo "Só leitura": ver as áreas, sem categorias restritas (essa é marcada à parte). */
export const INTEGRATION_READ_PERMISSIONS: Permission[] = ['payable.view', 'receivable.view', 'cards.view', 'bank.view', 'payroll.view', 'reports.view'];
/** Modelo "Leitura e escrita": tudo o que um token pode ter, menos categorias restritas e auditoria. */
export const INTEGRATION_WRITE_PERMISSIONS: Permission[] = INTEGRATION_PERMISSIONS.filter((p) => p !== 'bills.view_restricted' && p !== 'audit.view');

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
const IPV6 = /^[0-9a-f:]{2,39}(\/(12[0-8]|1[01]\d|\d?\d))?$/i;
/** IP ou faixa (CIDR), IPv4 ou IPv6. */
export const isIpOrCidr = (v: string) => IPV4.test(v) || (v.includes(':') && IPV6.test(v));

export const apiTokenSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome à integração').max(64),
  permissions: z.array(z.enum(INTEGRATION_PERMISSIONS as [string, ...string[]])).default([])
    .transform((p) => withRequired(p as Permission[]).filter((x) => INTEGRATION_PERMISSIONS.includes(x))),
  allowedIps: z.array(z.string().trim().refine(isIpOrCidr, 'IP ou faixa inválida (ex.: 203.0.113.10 ou 203.0.113.0/24)')).max(API_TOKEN_IPS_MAX).default([]),
  /** Último dia em que o token vale (no fuso do espaço); null = sem validade. */
  expiresAt: isoDate.nullable().default(null),
  /** Chamadas por minuto deste token; null = o padrão (`API_RATE_LIMIT_PER_MINUTE`). Ausente = não muda. */
  rateLimit: z.number().int('Use um número inteiro').min(API_RATE_LIMIT_MIN, `Mínimo de ${API_RATE_LIMIT_MIN} chamadas por minuto`).max(API_RATE_LIMIT_MAX, `Máximo de ${API_RATE_LIMIT_MAX} chamadas por minuto`).nullable().optional(),
});
export type ApiTokenInput = z.output<typeof apiTokenSchema>;

/** Grupos de eventos que um webhook pode escolher receber (vazio = todos). */
export const WEBHOOK_GROUPS = {
  bills: { label: 'Contas a pagar e a receber', prefixes: ['bill.', 'attachment.'] },
  catalog: { label: 'Categorias e pastas', prefixes: ['category.', 'folder.'] },
  cards: { label: 'Cartões', prefixes: ['card.'] },
  bank: { label: 'Contas bancárias', prefixes: ['bank.'] },
  payroll: { label: 'Folha de pagamento', prefixes: ['payroll.'] },
  signatures: { label: 'Assinatura de holerites', prefixes: ['payslip.'] },
  accounting: { label: 'Contador', prefixes: ['accounting.'] },
} as const;
export type WebhookGroup = keyof typeof WEBHOOK_GROUPS;
export const WEBHOOK_GROUP_KEYS = Object.keys(WEBHOOK_GROUPS) as WebhookGroup[];
/** Depois de 24 h falhando sem parar, o webhook é pausado até alguém salvar de novo. */
export const WEBHOOK_GIVE_UP_HOURS = 24;

export const webhookSchema = z.object({
  url: z.string().trim().min(1, 'Informe o endereço').max(500).refine((v) => { try { return ['https:', 'http:'].includes(new URL(v).protocol); } catch { return false; } }, 'Endereço inválido (ex.: https://sistema.exemplo.com/nopaper)'),
  groups: z.array(z.enum(WEBHOOK_GROUP_KEYS as [WebhookGroup, ...WebhookGroup[]])).default([]),
});

export interface WebhookInfo {
  url: string;
  groups: WebhookGroup[];
  /** ok | failing (tentando de novo) | stopped (pausado depois de 24 h de falhas) | null (nada enviado ainda) */
  status: 'ok' | 'failing' | 'stopped' | null;
  error: string | null;
  lastAt: string | null;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  /** Começo do token, para reconhecer qual é (o resto nunca é guardado). */
  hint: string;
  permissions: Permission[];
  allowedIps: string[];
  expiresAt: string | null;
  /** Chamadas por minuto; null = o padrão. */
  rateLimit: number | null;
  expired: boolean;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
  createdByName: string | null;
  webhook: WebhookInfo | null;
}
